# Online Tracks Bouncer

Free online multitrack audio mixer. Bounce stems, merge WAV/MP3 files, generate a click track and export your mix — all in the browser, nothing uploaded anywhere.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`

## Deploy

The live site is <https://kevinkirsten.github.io/online-tracks-bouncer/>.

There is no CI here — pushing does **not** update the site. Publishing is a
separate, manual step:

```sh
git push        # updates the source on `main` only
npm run deploy  # builds and publishes the site
```

`npm run deploy` runs `vite build` first (via the `predeploy` script — you do not
need to build by hand) and then force-pushes the contents of `dist/` to the
`gh-pages` branch, which is what GitHub Pages serves. Give it a minute or two to
go live, and hard-refresh (`Cmd+Shift+R`) if you still see the old version.

Run it from a clean tree: `gh-pages` publishes whatever `vite build` just
produced, so uncommitted local changes would go live too.

To check the production build before publishing:

```sh
npm run build && npm run preview
```

## How playback works

All tracks play from `AudioBufferSourceNode`s scheduled against a single shared
anchor in one `AudioContext` (`services/audioEngine.ts`). Because every source
starts at the same absolute `when`, they are locked together by the audio clock
and cannot drift — no matter how many play/pause/seek cycles happen. Waveforms
are plain canvases fed by a worker-computed envelope, and the playhead is driven
straight from the engine, so the visible needles always agree with what you hear.

## Pitch shifting

The global transposer renders each track offline through SoundTouch
(`services/pitchService.ts`) instead of processing it live. SoundTouch's WSOLA
pipeline introduces 120–140 ms of output delay that varies with the pitch value,
which used to drag transposed material behind the click. That delay is now
measured per pitch value with a calibration impulse and trimmed off, so shifted
tracks stay frame-aligned (measured error ≤ 2 ms). Preview and bounce share the
same render cache, so what you hear is what you export.

Tracks flagged as click tracks are never pitch-shifted.

## Click track

`Add click track` can analyse your stems to find the tempo and the first
downbeat (`services/tempo.worker.ts`): spectral-flux onset detection, an
autocorrelation with a tempo prior to pick the metrical level, a comb filter
matched against the whole onset envelope to pin the period down, then a
sample-domain pass for an unbiased phase. Offsets can be nudged on the track
afterwards and update instantly, even during playback.
