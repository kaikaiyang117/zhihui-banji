# AGENTS.md — 美美大王工作台 v2.2

## Setup & startup order

```
# 1. Backend deps (Python 3.11+)
pip install -r backend/requirements.txt

# 2. Frontend deps (Node 20+)
cd frontend
npm install
npm approve-scripts esbuild          # required on first install
npm run build                         # outputs to backend/static/

# 3. Data migration (first time only; preserves existing data)
cd backend
python migrate.py                     # reads legacy .xlsx into data/workbench.db

# 4. Run
python run.py                         # http://localhost:5000
```

Double-click `启动工作台.bat` for one-click launch (uses `%~dp0` to resolve the project root).

## Architecture (non-obvious)

- **SQLite is the database** (`data/workbench.db`, WAL mode). Excel files in `班主任工作台/` and `健康管理/` are **archived legacy sources only** — they are no longer read or written at runtime. openpyxl is used **only for import/export**.
- **SQLite thread quirk**: FastAPI sync endpoints run in a threadpool. `db.py` uses `check_same_thread=False` + a `threading.Lock` on the shared connection. Do not replace this with per-request connections without testing — the existing pattern works for single-user workloads.
- **Vite build outputs to `backend/static/`** (not `frontend/dist/`). FastAPI serves it from there. After any frontend change, run `npm run build` from `frontend/` and restart the server.
- **Derived columns** (`derived.py`): 成绩总分/积分排名/班费余额/腰臀比 are computed on read, never stored. This replaced the old Flask app's formula-hack code. When adding new computed columns, add a function to `DERIVERS` dict keyed by sheet name.
- **Student import dedupes on 学号**: `POST /api/students/import` merges by 学号 (new rows inserted, existing rows updated). Rows missing 学号 are skipped with an error message. The template endpoint (`/api/students/template`) builds the expected column layout.

## Router gotcha

App.vue is the shell (sidebar + top tabs + `<router-view />`), mounted by `createApp(App)` in `main.js`. The router **must not** include App as a route component — doing so causes a nested double-render with duplicated sidebars. Routes are flat:

```js
// router.js — correct pattern
const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue') },
  // ... all flat, no parent wrapper component
]
```

## Dev workflow

- `cd frontend && npm run dev` starts Vite dev server on :5173 with API proxy to :5000 — useful for frontend-only work
- No formatter/linter configured. No CI. No tests.
- npm has an `allow-scripts` policy that blocks esbuild's postinstall; run `npm approve-scripts esbuild` after install.

## Batch file encoding

`启动工作台.bat` must avoid hardcoded Chinese paths (`cd /d "%~dp0backend"`, not `cd /d "D:\Desktop\美美...\backend"`). Windows cmd.exe often garbles UTF-8 paths in batch files — `%~dp0` avoids that entirely.

## Key file map

| Purpose | Path |
|---------|------|
| Server entry | `backend/run.py` |
| DB schema + connection | `backend/app/db.py` |
| Derived columns | `backend/app/derived.py` |
| Student import logic | `backend/app/import_service.py` |
| Excel export | `backend/app/export_service.py` |
| Sheet metadata (headers, group) | `backend/app/config.py` → `SHEET_META` |
| Nav config + add-form fields | `frontend/src/sheets.js` |
| Vue router | `frontend/src/router.js` |
| Reusable sheet page | `frontend/src/components/SheetPage.vue` |
| Knowledge base (Obsidian) | `知识库/` (Markdown, not managed by backend) |
| Legacy Excel files | `班主任工作台/班主任工作台.xlsx`, `健康管理/健康追踪表.xlsx` |
