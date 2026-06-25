# Discord Favorite Manager

A local browser tool for managing Discord favorite GIF settings.

## Features

- Load a local `gifs.json` export.
- Fetch favorite GIF settings from Discord with a token.
- Decode and encode Discord's `settings-proto/2` protobuf payload in-browser.
- Refresh expired Discord attachment URLs.
- Preview GIFs and videos.
- Remove broken previews.
- Select, remove, drag-reorder, merge, and patch favorite GIFs back to Discord.
- Preserve non-GIF settings while replacing or merging only `favorite_gifs`.

## Usage

Serve the folder locally and open `index.html`:

```powershell
npm run serve
```

Or without npm:

```powershell
node server.mjs
```

Python also works:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8765/index.html
```

`preview.html` is kept as a compatibility redirect to `index.html`.

Using `file://` works for manual JSON loading, but local HTTP is recommended for the built-in `gifs.json` autoload path and Discord API calls.

## Token Notes

Discord token fields are transient browser inputs. Tokens are not stored by this app.

Actions that call Discord require a token:

- `Fetch gifs`
- `Refresh URLs`
- `Patch selected`
- `Patch All`

## Local Data

Local Discord exports such as `gifs.json` are ignored by Git. Keep those files private unless you intentionally want to share them.
