import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { registerBackgroundWork } from '../src/platform/background';
import { processLastResponse, runReconcile } from '../src/platform/runtime';

export default function RootLayout() {
  useEffect(() => {
    // Launch: categories and tasks, any answer that arrived before JS was listening, then re-plan.
    void (async () => {
      await registerBackgroundWork();
      await processLastResponse();
      await runReconcile();
    })();
    // Foreground: permission may have changed and the window may have run down.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void processLastResponse().then(() => runReconcile());
    });
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#FCF3F1' } }} />
    </>
  );
}
