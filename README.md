# LiveEdit-Style Waterfall Timeline

A local-LAN browser app for camera shot cueing.

- Admin imports CSV timelines/songs.
- Backend is the playback authority.
- iPad/iPhone/browser clients sync automatically over WebSocket.
- Camera operators can pin cameras like `C1`, `C2`, etc. while still seeing the full waterfall underneath.
- The pinned camera row now shows that camera's upcoming shot bars on the same horizontal time scale.
- Admin has a scrub slider for jumping through the active show timeline.
- Timelines can be opened from the admin list for renaming, CSV replacement, and removal.
- FPS is fixed at **25 fps**.
- Show timecode starts at **01:00:00:00**.

## CSV format

The CSV must contain these exact columns:

```csv
Index,Number,Name,Start,End,Duration,Color
```

Example:

```csv
M1,#1,C1 — slow zoom in,01:00:00:00,01:00:02:01,00:00:02:01,#f23800
```

The app parses cameras from the beginning of the `Name` field:

- `C1 — slow zoom in` → camera `C1`, description `slow zoom in`
- `C2 — zoom out` → camera `C2`, description `zoom out`
- `WHITE` / `BLACK` are shown in the waterfall but are not pinnable and do not show descriptions.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

or:

```bash
npm start
```

Then open:

```text
Admin: http://localhost:3000/admin
Live:  http://localhost:3000/
```

From other devices on the same LAN, use the server computer's IP address, for example:

```text
http://192.168.1.50:3000/admin
http://192.168.1.50:3000/
```

## Workflow

1. Open `/admin`.
2. Create/select a show.
3. Import a CSV with a timeline/song name.
4. Append more CSVs as more timelines/songs, or replace an existing timeline.
5. Use the timeline list to edit names, replace CSV data, or remove timelines.
6. Use Start/Pause/Stop/Reset, or scrub with the slider.
7. Operators open `/` on iPad/iPhone and pick their pinned camera.

## Storage

Data is stored as JSON in:

```text
data/state.json
```

Delete that file if you want to reset everything.

## Notes for iOS

- Works best in Safari.
- Add the Live page to the home screen for a more app-like full-screen feel.
- Keep the device awake manually for now; a future version can add stronger wake-lock handling where supported.

## Current MVP limitations

- No authentication yet.
- No database; file-based JSON storage only.
- No audio/video playback control yet.
- The UI is optimized for readable operator cueing rather than editing timelines.
