# The HomeIomp app bridge

This fork is served at `https://homeiomp.xyz/stremio` and is also the entire UI of the native
HomeIomp Stremio app for iOS, which loads that URL in a `WKWebView`. The bridge is how the two
halves talk: the page offers download actions the web cannot honour on its own, and the app
answers with the state of the downloads it is holding.

Everything is gated on one marker. In a normal browser the marker is absent, `isHomeIompApp()`
returns `false`, no affordance renders and no message is ever posted — the deployed site is
unchanged for anyone who is not inside the app.

Module: [`src/common/homeiompBridge.ts`](../src/common/homeiompBridge.ts), re-exported from
`stremio/common`.

## What the app must inject

Two things, and the marker must be injected **at document start** (`WKUserScriptInjectionTime
.atDocumentStart`, `forMainFrameOnly: true`) so the first React render already sees it:

```swift
let source = """
window.__HOMEIOMP_APP__ = { platform: "ios", version: "1" };
"""
let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
configuration.userContentController.addUserScript(script)
configuration.userContentController.add(self, name: "homeiomp")   // the message handler
```

The handler name is exactly `homeiomp`, so the page reaches it at
`window.webkit.messageHandlers.homeiomp.postMessage(...)`.

`isHomeIompApp()` is true when **either** the marker **or** the message handler is present, so an
app build that registers the handler but forgets the marker still lights the UI up rather than
looking broken. `homeIompAppInfo()` returns `{ platform, version }` (both strings) or `null`.

Every message is passed through `JSON.parse(JSON.stringify(...))` before it is handed over:
`WKWebView` only carries serialisable values, dates become ISO strings, `undefined` keys vanish,
and anything exotic throws inside the bridge instead of silently dropping the message.
`postToApp()` returns `false` when there is no handler or the payload was refused; the UI uses
that to toast "the app did not take this download" rather than leave a tap with no outcome.

## Page → app

`postToApp(type, payload)` posts `{ type, ...payload }`. Two types exist today.

### `download`

Posted by the Download / Download season action on a stream row.

```json
{
  "type": "download",
  "scope": "episode",
  "id": "tt0944947:1:1|8a3d5f...c91:0",
  "meta": {
    "id": "tt0944947",
    "type": "series",
    "name": "Game of Thrones",
    "poster": "https://.../poster.jpg",
    "background": "https://.../background.jpg",
    "videos": [
      {
        "id": "tt0944947:1:1",
        "season": 1,
        "episode": 1,
        "title": "Winter Is Coming",
        "released": "2011-04-17T21:00:00.000Z",
        "thumbnail": "https://.../thumb.jpg"
      }
    ]
  },
  "video": {
    "id": "tt0944947:1:1",
    "season": 1,
    "episode": 1,
    "title": "Winter Is Coming",
    "released": "2011-04-17T21:00:00.000Z"
  },
  "stream": {
    "name": "Torrentio\n1080p",
    "title": null,
    "description": "Game.of.Thrones.S01E01.1080p...",
    "infoHash": "8a3d5f...c91",
    "fileIdx": 0,
    "url": null,
    "ytId": null,
    "externalUrl": null,
    "sources": ["tracker:udp://tracker.opentrackr.org:1337/announce", "dht:8a3d5f...c91"],
    "behaviorHints": { "bingeGroup": "torrentio|1080p", "filename": "...", "videoSize": 2147483648 }
  },
  "addon": {
    "transportUrl": "https://torrentio.strem.fun/manifest.json",
    "name": "Torrentio"
  },
  "subtitles": [
    { "lang": "eng", "url": "https://opensubtitles.../1.srt", "source": "OpenSubtitles v3" },
    { "lang": "eng", "url": "https://opensubtitles.../2.srt", "source": "OpenSubtitles v3" }
  ],
  "addons": [
    { "transportUrl": "https://opensubtitles-v3.strem.io/manifest.json", "name": "OpenSubtitles v3" },
    { "transportUrl": "https://subs.example/manifest.json", "name": "Some Subs" }
  ]
}
```

Field notes, all of them load-bearing:

- **`scope`** is `"episode"` (this stream, this video) or `"season"`. On `"season"` the app
  resolves the other episodes itself: it has `addon.transportUrl` and the meta's full `videos`
  list, so it can call `stream/<type>/<videoId>.json` on the same addon for each episode of
  `video.season` and pick a stream by the same rules it likes. The page deliberately does not
  reimplement the addon protocol.
- **`id`** is the download identity, and it is the string the app **must** echo back in
  `downloadState` items or the row badge will never find its row. It is
  `` `${videoId}|${infoHash}:${fileIdx}` `` for a torrent, and `` `${videoId}|${url ?? ytId ??
  externalUrl}` `` otherwise (`fileIdx` empty when absent). Source-derived rather than random,
  so it survives a page reload: the same stream on the same episode is the same download.
  Exported as `downloadItemId(videoId, stream)` if the app-facing code ever needs to rebuild it.
- **`meta.videos`** is sent for both scopes and can be long (hundreds of entries for a
  long-running series). It is built on tap, never on render.
- **`stream.infoHash` may be `null`.** A stream that is only a `url`, a `ytId` or an
  `externalUrl` is posted all the same — the app decides what it can do with it. Exactly one of
  the four source fields is non-null in practice.
- **`stream.sources`** is the addon protocol's tracker/DHT list. `stremio-core` deserialises it
  under the name `announce`; the bridge reads either and posts it under the protocol's name.
- **`stream.title`** is almost always `null`: the addon protocol deprecated it in favour of
  `description`, and `stremio-core` does not carry it. `description` is the line the UI shows;
  `name` is the short addon/quality label.
- **`stream.behaviorHints`** is passed through untouched (`bingeGroup`, `filename`, `videoSize`,
  `notWebReady`, `countryWhitelist`, `proxyHeaders`, …). `filename`/`videoSize` are the useful
  ones for naming and sizing a download.
- **`subtitles`** is up to **five English subtitle files**, `[{ lang, url, source }]`, resolved
  **on the tap** and never on render. The stream's own `subtitles` come first (they were
  authored against this exact release, so they are the most likely to be in sync), then every
  installed addon that declares the `subtitles` resource is asked
  `<transportUrl minus manifest.json>subtitles/<type>/<videoId>.json` — in install order, so
  OpenSubtitles wins the top slots when it is installed. Each request gets **4 s** and any
  failure (down, slow, CORS) contributes nothing rather than stopping the download. English is
  `en` / `eng` / `english`, case-insensitive, region suffixes ignored. Duplicated URLs are
  dropped. `source` is the addon's name, carried only so a human can tell one track from
  another. The list is often empty, and that is not an error.
- **`addons`** is the same subtitle-capable addon list (`[{ transportUrl, name }]`, at most 8),
  sent so the app can ask the identical question per episode when it resolves the rest of a
  season. The page resolves subtitles for the tapped video only; it deliberately does not walk
  a season itself.
- **`released`** values are ISO strings (the core hands the page real `Date` objects; the bridge
  converts them). Missing dates are `null`, never `Invalid Date`.
- **`meta`**, **`video`** and **`addon`** are `null` rather than absent when unknown.

### `openDownloads`

```json
{ "type": "openDownloads" }
```

Posted by the "Downloads" entry in the nav menu (app-only). No payload — it just asks the app to
show its own Downloads screen.

## App → page

The bridge installs `window.homeiompApp` at module load:

```js
window.homeiompApp.onEvent(eventOrJsonString) // -> true if the event was understood
```

It accepts an object **or** a JSON string, because evaluating JavaScript from Swift usually means
building a string anyway:

```swift
let json = String(data: try JSONEncoder().encode(event), encoding: .utf8)!
webView.evaluateJavaScript("window.homeiompApp && window.homeiompApp.onEvent(\(json))")
```

Every event needs a `type`. Unknown types are dispatched to subscribers and otherwise ignored, so
new ones can be added without a web release.

### `downloadState`

```json
{
  "type": "downloadState",
  "items": [
    { "id": "tt0944947:1:1|8a3d5f...c91:0", "state": "downloading", "progress": 42 },
    { "id": "tt0944947:1:2|1b7c...aa2:0", "state": "done" }
  ]
}
```

- `state`: `queued` | `downloading` | `paused` | `done` | `failed`. An unrecognised value is shown
  verbatim as a neutral badge rather than dropped.
- `progress`: percent, `0`–`100`, optional.
- Items are **merged** into the page's cache by `id`, not replaced wholesale, so the app may push
  only what changed. The cache is memory-only and is lost on reload — push a full snapshot once
  after the page loads (a `didFinish` navigation callback is the natural place).

A row shows `Downloaded` for `done`, `NN%` when there is a progress number, and the state string
otherwise; the icon becomes a checkmark for `done` and a warning for `failed`.

### Subscribing from page code

```js
const { onAppEvent, useDownloadState } = require('stremio/common');

const unsubscribe = onAppEvent('downloadState', (event) => { /* ... */ });  // '*' for all events
const state = useDownloadState(id);   // React hook, re-renders only when that id's state changes
```

## Where the UI hooks live

| File | What it does |
| --- | --- |
| `src/common/homeiompBridge.ts` | The whole bridge: detection, `postToApp`, the event emitter, `downloadItemId`, `buildDownloadPayload`, `useDownloadState`, and the subtitle resolver (`subtitleAddons`, `subtitlesResourceUrl`, `fetchEnglishSubtitles`). |
| `src/common/index.js` | Re-exports the bridge from `stremio/common`. |
| `src/routes/MetaDetails/MetaDetails.js` | Passes the loaded meta (`metaItem`) down to the streams list. |
| `src/routes/MetaDetails/StreamsList/StreamsList.js` | Keeps each stream's addon on the stream, decides whether a season can be downloaded, passes meta/video/stream/addon to each row. |
| `src/routes/MetaDetails/StreamsList/Stream/Stream.js` | The Download and Download season actions, in the row and in the long-press context menu, plus the state badge. |
| `src/routes/MetaDetails/StreamsList/Stream/styles.less` | `.download-actions` / `.download-button` — always visible, quieter than the accent play circle. |
| `src/components/NavBar/HorizontalNavBar/NavMenu/NavMenuContent.js` | The app-only "Downloads" nav-menu entry. |

Nothing in playback, the service worker or `src/App/DefaultStreamingServerHandler.js` was touched.

## Testing it in a desktop browser

Paste this into dev tools **before** navigating to a meta page (or paste it and reload the route),
then open any movie or episode: the stream rows grow a Download button, series rows also get a
season button, and the nav menu grows a Downloads entry. Every message is logged instead of sent.

```js
// Fake the HomeIomp app: the marker plus a message handler that logs.
window.__HOMEIOMP_APP__ = { platform: 'ios', version: '1' };
window.webkit = window.webkit || {};
window.webkit.messageHandlers = window.webkit.messageHandlers || {};
window.webkit.messageHandlers.homeiomp = {
    postMessage: (message) => {
        console.log('[homeiomp ->]', message);
        window.lastHomeIompMessage = message;
        // Answer a download the way the app would.
        if (message.type === 'download') {
            let progress = 0;
            const tick = setInterval(() => {
                progress += 20;
                window.homeiompApp.onEvent(JSON.stringify({
                    type: 'downloadState',
                    items: [{
                        id: message.id,
                        state: progress >= 100 ? 'done' : 'downloading',
                        progress: Math.min(progress, 100),
                    }],
                }));
                if (progress >= 100) clearInterval(tick);
            }, 1000);
        }
    },
};
location.reload();   // the marker is read at render time; reload so every row sees it
```

A tap now makes one request per installed subtitle addon before the message is posted, so the
message arrives up to four seconds after the click and the network tab shows the
`subtitles/<type>/<videoId>.json` calls. With no subtitle addon installed there are no requests
and `subtitles` is whatever the stream itself carried.

Then inspect what a tap produced:

```js
copy(JSON.stringify(window.lastHomeIompMessage, null, 2));
```

To check the other direction on its own:

```js
window.homeiompApp.onEvent({ type: 'downloadState', items: [{ id: window.lastHomeIompMessage.id, state: 'failed' }] });
```

Removing the marker and the handler and reloading returns the page to its normal browser state —
which is the invariant worth re-checking after any change here.
