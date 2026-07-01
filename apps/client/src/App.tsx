import { AuthScreen } from "./components/AuthScreen";
import { AppShell } from "./components/AppShell";
import { useSessionBootstrap } from "./hooks/useAuthActions";
import { useAppStore } from "./store/appStore";
import "./styles.css";

export function App() {
  const user = useAppStore((state) => state.user);

  useSessionBootstrap();

  return user ? <AppShell /> : <AuthScreen />;
}
