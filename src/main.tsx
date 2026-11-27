import "./polyfills";
import { Component, type ErrorInfo, type ReactNode, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initPlatform } from "./platform";
import { initGamepadNav } from "./gamepadNav";
import { installSoundUnlock } from "./components/sound/engine";

// neither may keep the interface from starting (a WebView without some API, a phone sensor listed as a gamepad…)
try { initPlatform(); } catch (e) { console.error("platform init failed:", e); }
try { initGamepadNav(); } catch (e) { console.error("gamepad navigation init failed:", e); }
// the match sound starts on the first tap / click (browsers allow audio only from a gesture)
try { installSoundUnlock(); } catch (e) { console.error("sound init failed:", e); }

/** Tells the boot watchdog in index.html that React has drawn the interface. */
function Mounted({ children }: { children: ReactNode }) {
  useEffect(() => { (window as Window & { __khlMounted?: boolean }).__khlMounted = true; }, []);
  return <>{children}</>;
}

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("KHL Manager render error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#0b1420", color: "#e8eef5", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "sans-serif" }}>
          <div style={{ maxWidth: "460px", background: "#121d2e", border: "1px solid #24354f", borderRadius: "8px", padding: "20px" }}>
            <div style={{ fontWeight: 700, fontSize: "16px", color: "#e5323e", marginBottom: "8px" }}>Ошибка запуска интерфейса</div>
            <div style={{ fontSize: "13px", color: "#93a4bc", wordBreak: "break-word", marginBottom: "16px" }}>
              {this.state.error.message || String(this.state.error)}
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ background: "#e5323e", color: "#fff", border: "none", borderRadius: "4px", padding: "8px 14px", fontWeight: 600, cursor: "pointer" }}
            >
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <Mounted>
        <App />
      </Mounted>
    </RootErrorBoundary>
  </StrictMode>
);

