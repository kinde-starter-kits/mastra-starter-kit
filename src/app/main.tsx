import React from 'react';
import {createRoot} from 'react-dom/client';
import {KindeProvider} from '@kinde-oss/kinde-auth-react';

import {App} from './App';
import {env} from './env';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <KindeProvider
      domain={env.kindeDomain}
      clientId={env.kindeClientId}
      redirectUri={env.redirectUri}
      logoutUri={env.logoutUri}
      audience={env.audience}
    >
      <App />
    </KindeProvider>
  </React.StrictMode>
);
