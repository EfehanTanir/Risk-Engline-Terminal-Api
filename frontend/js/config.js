// Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
// SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

// API base configuration.
// The backend is a Python FastAPI service (see backend/). After deploying it
// on Vercel, replace BACKEND_PROD below with your deployment URL + /api,
// e.g. "https://finansla-api.vercel.app/api".
// You can also override at runtime from the browser console:
//   localStorage.setItem('finansla_api_base', 'https://my-api.vercel.app/api')
(function () {
  const BACKEND_PROD = 'https://risk-engline-terminal-api.vercel.app/api';
  const BACKEND_DEV = 'http://localhost:8000/api';              // uvicorn default port
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
  window.FINANSLA = {
    API_BASE: localStorage.getItem('finansla_api_base') || (isLocal ? BACKEND_DEV : BACKEND_PROD),
  };
})();
