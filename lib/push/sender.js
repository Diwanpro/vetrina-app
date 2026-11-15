// SERVER-ONLY Web Push sender (v3.1). VAPID keys never leave this module.

// web-push is CommonJS: a namespace import keeps both Node ESM and the Next
// server bundler happy (a default import produces a "no default export" warning).
import * as webpush from 'web-push'
import { vapidConfig, pushConfigured } from './config.js'

export { pushConfigured }

export async function sendPush(subscription, payload) {
  const config = vapidConfig()
  if (!config) throw new Error('PUSH_NOT_CONFIGURED')
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey)
  return webpush.sendNotification({
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  }, JSON.stringify(payload), {
    TTL: 3600,
    urgency: 'normal',
  })
}

export function isExpiredSubscription(error) {
  return error?.statusCode === 404 || error?.statusCode === 410
}
