// Sends a push notification through Expo's push service. Expo tokens only -- the mobile app only ever
// produces ExponentPushToken[...] values, not raw APNs/FCM tokens, so no provider branching is needed.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendPushNotification(tokens: string[], title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({ to, title, body, sound: 'default', priority: 'high', data }))),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Best-effort: a failed push never blocks the alert itself, which is already saved and visible in-app.
  }
}
