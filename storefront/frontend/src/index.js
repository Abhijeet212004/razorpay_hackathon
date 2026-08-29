import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import { BrowserRouter as Router } from 'react-router-dom';
import { Provider } from 'react-redux';
import store from './store';
import { SnackbarProvider } from 'notistack';

// A link handed to the browser percent-encoded — "/%2Fagent%2Fauthorize%3Fref%3D..." —
// arrives here in an odd state: Chrome decodes it when requesting the page, so the server
// serves the app correctly, but leaves window.location holding the encoded string. The
// router then matches nothing and renders the 404, with the server none the wiser.
//
// Rewriting the address before the router mounts is the only place this can be fixed.
// Leading slashes are collapsed rather than rejected: "/%2Fagent" decodes to "//agent",
// which is the case this exists for, while "//host/path" would be protocol-relative and
// could leave the origin — collapsing makes both a local path.
(function normaliseEncodedLocation() {
    const here = window.location.pathname + window.location.search;
    if (!/%2f|%3f/i.test(here)) return;
    let decoded;
    try {
        decoded = decodeURIComponent(here);
    } catch {
        return;
    }
    decoded = decoded.replace(/^\/+/, '/');
    if (decoded.startsWith('/') && decoded !== here) {
        window.history.replaceState(null, '', decoded);
    }
})();

ReactDOM.render(
  <React.StrictMode>
    <Provider store={store}>
      <SnackbarProvider
        maxSnack={2}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'center',
        }}
      >
        <Router>
          <App />
        </Router>
      </SnackbarProvider>
    </Provider>
  </React.StrictMode>,
  document.getElementById('root')
);