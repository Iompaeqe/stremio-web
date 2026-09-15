// HomeIomp: the LAN door state machine (src/common/streamingDoor.ts).
//
// STR-27 is a bug that only exists in time: the door was right when it was decided and wrong four
// minutes later, because the phone had left the house and the verdict had not. Nothing about it is
// visible in a single call, so what is tested here is the sequence — probe, expire, invalidate,
// fail over, and never trusting what a previous session wrote down.
//
// The module is loaded by hand rather than required, for two reasons. It is TypeScript and this
// repo has no jest transform (webpack owns ts-loader, and adding a babel config for the tests
// would change what webpack does to every other file). And it keeps module-level state — the whole
// point of it — so every test needs its own instance of that state, which `require` would cache.
// The compiler is the project's own typescript devDependency; the injected parameters shadow the
// globals the module reaches for, which is also how the clock and the network get to be fakes.

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SOURCE = path.join(__dirname, '..', 'src', 'common', 'streamingDoor.ts');

const COMPILED = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
    },
}).outputText;

const PUBLIC_URL = 'https://homeiomp.xyz/stremio-server/';
const LAN_URL = 'https://lan.homeiomp.xyz/stremio-server/';

const makeWorld = ({ storage = {}, connection = true } = {}) => {
    let now = 1600000000000;
    const store = new Map(Object.entries(storage));
    const listeners = { window: {}, document: {}, connection: {} };
    const requests = [];
    let responder = () => Promise.reject(new Error('lan unreachable'));

    const addEventListener = (bucket) => (type, handler) => {
        listeners[bucket][type] = (listeners[bucket][type] || []).concat(handler);
    };

    const fetchImpl = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        requests.push(url);
        return responder(url, init);
    };

    const world = {
        requests,
        visibility: 'visible',
        advance: (ms) => { now += ms; },
        answers: (fn) => { responder = fn; },
        lanIsThere: () => { responder = () => Promise.resolve({ ok: true, status: 200 }); },
        lanIsGone: () => { responder = () => Promise.reject(new Error('Failed to fetch')); },
        fire: (bucket, type) => {
            (listeners[bucket][type] || []).forEach((handler) => handler({ type }));
        },
        stored: (key) => (store.has(key) ? store.get(key) : null),
    };

    world.globals = {
        window: { addEventListener: addEventListener('window'), fetch: fetchImpl },
        document: {
            addEventListener: addEventListener('document'),
            createElement: () => ({}),
            get visibilityState() { return world.visibility; },
        },
        navigator: connection ? { connection: { addEventListener: addEventListener('connection') } } : {},
        localStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => { store.set(key, String(value)); },
            removeItem: (key) => { store.delete(key); },
        },
        fetch: fetchImpl,
        AbortController: function AbortControllerFake() {
            this.signal = {};
            this.abort = () => {};
        },
        // The probe's timeout never fires on its own here; every probe is resolved or rejected by
        // the fake network, which is the only thing these tests are about.
        setTimeout: () => 0,
        clearTimeout: () => {},
        Date: { now: () => now },
    };

    return world;
};

const loadDoor = (world) => {
    const moduleObject = { exports: {} };
    const names = Object.keys(world.globals);
    // eslint-disable-next-line no-new-func
    const factory = new Function('module', 'exports', ...names, COMPILED);
    factory(moduleObject, moduleObject.exports, ...names.map((name) => world.globals[name]));
    return moduleObject.exports;
};

describe('streamingDoor', () => {
    describe('lanDoorFor', () => {
        it('maps the public streaming server onto the LAN host', () => {
            const door = loadDoor(makeWorld());
            expect(door.lanDoorFor(PUBLIC_URL)).toBe(LAN_URL);
        });

        it('leaves anything that is not our public streaming server alone', () => {
            const door = loadDoor(makeWorld());
            expect(door.lanDoorFor('http://127.0.0.1:11470/')).toBe(null);
            expect(door.lanDoorFor('https://homeiomp.xyz/cloud/')).toBe(null);
            expect(door.lanDoorFor('http://homeiomp.xyz/stremio-server/')).toBe(null);
            expect(door.lanDoorFor('https://example.com/stremio-server/')).toBe(null);
            expect(door.lanDoorFor(null)).toBe(null);
        });
    });

    describe('isLanDoorBase', () => {
        it('recognises every URL addressed at the LAN door, base or segment', () => {
            const door = loadDoor(makeWorld());
            expect(door.isLanDoorBase(LAN_URL)).toBe(true);
            expect(door.isLanDoorBase(LAN_URL + 'hlsv2/abc/master.m3u8')).toBe(true);
            expect(door.isLanDoorBase(PUBLIC_URL)).toBe(false);
            expect(door.isLanDoorBase(undefined)).toBe(false);
            expect(door.isLanDoorBase('not a url')).toBe(false);
        });
    });

    describe('at home', () => {
        it('uses the LAN door once the probe answers', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
            await door.ensureStreamingDoor(PUBLIC_URL);

            expect(world.requests).toEqual([LAN_URL + 'settings']);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });

        it('does not probe again for the next playback seconds later', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.advance(15 * 1000);
            await door.ensureStreamingDoor(PUBLIC_URL);

            expect(world.requests).toHaveLength(1);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });
    });

    describe('the verdict expiring — STR-27', () => {
        it('re-probes a LAN verdict older than twenty seconds and falls back to the tunnel', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);

            // The phone is now on mobile data, and nothing told the page so.
            world.advance(25 * 1000);
            world.lanIsGone();
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(2);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('trusts a tunnel verdict for minutes, because it is true anywhere', async () => {
            const world = makeWorld();
            world.lanIsGone();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.advance(60 * 1000);
            await door.ensureStreamingDoor(PUBLIC_URL);

            expect(world.requests).toHaveLength(1);

            world.advance(5 * 60 * 1000);
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(2);
        });
    });

    describe('the network moving', () => {
        it.each([
            ['window', 'online'],
            ['window', 'offline'],
            ['connection', 'change'],
        ])('throws the verdict away on %s %s', async (bucket, type) => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);

            world.fire(bucket, type);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);

            world.lanIsGone();
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(2);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('throws the verdict away when the page comes back to the foreground', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.visibility = 'hidden';
            world.fire('document', 'visibilitychange');
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);

            world.visibility = 'visible';
            world.fire('document', 'visibilitychange');
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('notices walking back IN, not only walking out', async () => {
            const world = makeWorld();
            world.lanIsGone();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);

            world.lanIsThere();
            world.fire('window', 'online');
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });

        it('survives a browser with no Network Information API', async () => {
            const world = makeWorld({ connection: false });
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });
    });

    describe('falling back mid-stream', () => {
        it('abandons the LAN door the moment one of its requests fails', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);

            expect(door.noteStreamingDoorFailure(LAN_URL, 'MediaError 2')).toBe(true);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('reports nothing for a failure that was not on the LAN door', () => {
            const door = loadDoor(makeWorld());
            expect(door.noteStreamingDoorFailure(PUBLIC_URL, 'MediaError 2')).toBe(false);
            expect(door.noteStreamingDoorFailure(null, 'MediaError 2')).toBe(false);
        });

        it('holds the LAN door off afterwards, so the retry cannot be built on it again', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            door.noteStreamingDoorFailure(LAN_URL, 'MediaError 2');

            // Even though the cheap probe would answer, and even though the record has expired.
            world.advance(30 * 1000);
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(1);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);

            // Two minutes later it is allowed to try again.
            world.advance(2 * 60 * 1000);
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(2);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });

        it('forgives the block when the owner taps the line in Settings', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            door.noteStreamingDoorFailure(LAN_URL, 'MediaError 2');

            await door.ensureStreamingDoor(PUBLIC_URL, { force: true });
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });

        it('hears a failed player request through the fetch observer', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);

            world.lanIsGone();
            await expect(world.globals.window.fetch(LAN_URL + 'hlsv2/abc/master.m3u8')).rejects.toThrow();
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('does not treat an aborted request as the LAN door being gone', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.answers(() => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                return Promise.reject(error);
            });

            await expect(world.globals.window.fetch(LAN_URL + 'hlsv2/abc/seg1.m4s')).rejects.toThrow();
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });

        it('does not let its own failing probe arm the block', async () => {
            const world = makeWorld();
            world.lanIsGone();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.lanIsThere();
            world.fire('window', 'online');
            await door.ensureStreamingDoor(PUBLIC_URL);

            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });
    });

    describe('what a previous session wrote down', () => {
        it('is never routed on, however recent it looks', async () => {
            const world = makeWorld({
                storage: {
                    'homeiomp.door.last': JSON.stringify({
                        at: 1600000000000,
                        lan: LAN_URL,
                        detail: 'LAN (7ms)',
                        reason: 'startup',
                    }),
                },
            });
            world.lanIsGone();
            const door = loadDoor(world);

            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
            expect(door.streamingDoorReport(PUBLIC_URL)).toContain('previous session');

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('survives a localStorage full of nonsense', () => {
            const world = makeWorld({ storage: { 'homeiomp.door.last': 'not json' } });
            const door = loadDoor(world);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
            expect(door.streamingDoorReport(PUBLIC_URL)).toContain('not probed yet');
        });
    });

    describe('the switch', () => {
        it('never probes while the LAN door is off', async () => {
            const world = makeWorld({ storage: { 'homeiomp.lan': '0' } });
            world.lanIsThere();
            const door = loadDoor(world);

            expect(door.isLanDoorEnabled()).toBe(false);
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(0);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
        });

        it('takes effect immediately in both directions', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);

            door.setLanDoorEnabled(false);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(PUBLIC_URL);
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(world.requests).toHaveLength(1);

            door.setLanDoorEnabled(true);
            await door.ensureStreamingDoor(PUBLIC_URL);
            expect(door.streamingServerDoor(PUBLIC_URL)).toBe(LAN_URL);
        });
    });

    describe('the report', () => {
        it('says which door, why it was chosen and how long ago', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.advance(10 * 1000);

            const report = door.streamingDoorReport(PUBLIC_URL);
            expect(report).toContain('lan.homeiomp.xyz');
            expect(report).toContain('startup');
            expect(report).toContain('10s ago');
            expect(report).not.toContain('expired');
        });

        it('admits when the verdict it is showing has expired', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            world.advance(30 * 1000);

            const report = door.streamingDoorReport(PUBLIC_URL);
            // The head is the tunnel, because that is what playback would use this second.
            expect(report.startsWith(PUBLIC_URL)).toBe(true);
            expect(report).toContain('expired, re-probed on play');
        });

        it('names the reason the door last switched', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            door.noteStreamingDoorFailure(LAN_URL, 'MediaError 2');

            const report = door.streamingDoorReport(PUBLIC_URL);
            expect(report).toContain('LAN door failed');
            expect(report).toContain('MediaError 2');
        });

        it('explains a door held off after a failure', async () => {
            const world = makeWorld();
            world.lanIsThere();
            const door = loadDoor(world);

            await door.ensureStreamingDoor(PUBLIC_URL);
            door.noteStreamingDoorFailure(LAN_URL, 'MediaError 2');
            world.advance(30 * 1000);
            await door.ensureStreamingDoor(PUBLIC_URL);

            expect(door.streamingDoorReport(PUBLIC_URL)).toContain('held off after a failure');
        });

        it('says so when there is no streaming server at all', () => {
            const door = loadDoor(makeWorld());
            expect(door.streamingDoorReport(null)).toContain('no streaming server');
        });
    });
});
