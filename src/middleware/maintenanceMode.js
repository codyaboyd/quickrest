import { getSetting } from '../services/adminSettingsService.js';

export function maintenanceMode() {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const user = c.get('user');
    if (path === '/health' || path.startsWith('/assets/') || path.startsWith('/admin') || user?.role === 'admin') return next();
    if (await getSetting('platform.maintenance_mode', false)) {
      const message = await getSetting('platform.maintenance_message', 'Service unavailable for maintenance.');
      return c.json({ error: message, requestId: c.get('requestId') }, 503);
    }
    await next();
  };
}
