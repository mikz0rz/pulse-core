# Pulse frontend

The React + Vite + TypeScript frontend for Pulse. Own `package.json`/`node_modules`, separate from the backend at the project root — see the [root README](../README.md) for what Pulse is and how to configure/run it.

```bash
npm install
npm run dev      # dev server, proxies /api to http://localhost:3000 (see vite.config.ts)
npm run build    # tsc -b && vite build -> dist/, served by the backend Express process in production
```

There is no separate frontend host — `npm start` at the project root serves `dist/` directly.
