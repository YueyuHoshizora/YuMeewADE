import { app } from 'electron';
import { configureSecretApplication, createSecretRequestHandler } from './secret-service.ts';

// Launched only by the core with a private Node child IPC channel; no windows or sockets.
if (!process.send || !process.connected) {
  app.exit(1);
} else {
  configureSecretApplication();
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  process.on('disconnect', () => app.exit(0));
  const handle = createSecretRequestHandler(message => {
    if (process.connected) process.send?.(message, error => { if (error) app.exit(1); });
  });
  process.on('message', handle);
}
