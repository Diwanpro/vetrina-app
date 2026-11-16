/* v3.1 compatibility entry point.
 * The canonical worker is /service-worker.js (shell cache + Web Push handlers).
 * Keeping this shim means older installed dashboards keep receiving updates.
 */
importScripts('/service-worker.js');
