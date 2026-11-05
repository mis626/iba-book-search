# IBA Smart Book Search (V4)

- `index.html` — frontend (GitHub Pages), calls the Apps Script web app.
- `apps-script/` — Google Apps Script backend (bound to the IMS Google Sheet), managed with [clasp](https://github.com/google/clasp).

## Deploy backend

```bash
npm i -g @google/clasp
clasp login
cd apps-script
clasp pull      # first time only: fetches the existing appsscript.json manifest
clasp push
```

Then in the Apps Script editor run `setupProject` once, and redeploy the web app if the `/exec` URL changes (update `API_URL` in `index.html`).
