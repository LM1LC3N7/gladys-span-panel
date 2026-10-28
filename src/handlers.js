// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// BEFORE connect().
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices of the panel read in the current session, never a request by itself.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));

  // The relay list of a circuit (refused unless the option allows it: src/app.js).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.PAIR, () => app.pair());
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  // The only way to take a counter held back, in two clicks (a save of the form never does).
  gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldCounter());

  // Configuration changed by the user: applied one after the other, the last one wins.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config, { fresh: true });
  });

  // Every connection (the first one and each reconnection) starts again: the
  // session, Discovery and the status. A failed getConfig() is asked again
  // without end (src/app.js connectedVia).
  gladys.on('connected', async () => {
    try {
      await app.connectedVia(() => gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
  gladys.on('disconnected', () => {
    app.stop().catch((err) => logger?.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
}
