import { useEffect, useRef, useState } from "react"
import { CenterAlert, SectionHeader } from "../components"
import { useTranslation } from "../lib/i18n"
import { askAnalyst } from "../lib/analyst"

interface ChatMessage {
  role: "user" | "assistant"
  text: string
}

const SUGGESTED_KEYS = [
  "analystPage.suggestedSnapshot",
  "analystPage.suggestedTopProducts",
  "analystPage.suggestedForecast",
  "analystPage.suggestedLowStock",
  "analystPage.suggestedInsurance",
] as const

export default function AnalystPage() {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }) }, [messages, asking])
  useEffect(() => { inputRef.current?.focus() }, [])

  async function send(question: string) {
    const trimmed = question.trim()
    if (!trimmed || asking) return
    setMessages(current => [...current, { role: "user", text: trimmed }])
    setInput("")
    setAsking(true)
    setError("")
    try {
      const answer = await askAnalyst(trimmed)
      setMessages(current => [...current, { role: "assistant", text: answer }])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("analystPage.error"))
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 140px)" }}>
      {error && <CenterAlert key={error} message={error} />}
      <SectionHeader title={t("analystPage.title")} subtitle={t("analystPage.subtitle")} />

      <div style={{ flex: 1, overflowY: "auto", background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ margin: "auto", maxWidth: 480, textAlign: "center" }}>
            <div style={{ fontSize: 30, marginBottom: 10 }}>🧠</div>
            <div style={{ fontSize: 13, color: "var(--ink-muted)", marginBottom: 16 }}>{t("analystPage.emptyHint")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SUGGESTED_KEYS.map(key => (
                <button
                  key={key}
                  onClick={() => void send(t(key))}
                  style={{ textAlign: "left", padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--ink)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "78%", padding: "10px 14px", borderRadius: 12, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap",
              background: m.role === "user" ? "var(--primary)" : "var(--bg)",
              color: m.role === "user" ? "#fff" : "var(--ink)",
              borderBottomRightRadius: m.role === "user" ? 2 : 12,
              borderBottomLeftRadius: m.role === "assistant" ? 2 : 12,
            }}>
              {m.text}
            </div>
          </div>
        ))}

        {asking && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ padding: "10px 14px", borderRadius: 12, borderBottomLeftRadius: 2, background: "var(--bg)", color: "var(--ink-muted)", fontSize: 12 }}>
              {t("analystPage.thinking")}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input) } }}
          placeholder={t("analystPage.inputPlaceholder")}
          rows={1}
          disabled={asking}
          style={{ flex: 1, resize: "none", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 13, fontFamily: "inherit", outline: "none" }}
        />
        <button
          onClick={() => void send(input)}
          disabled={asking || !input.trim()}
          style={{
            padding: "10px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
            background: "var(--primary)", color: "#fff", cursor: asking || !input.trim() ? "not-allowed" : "pointer",
            opacity: asking || !input.trim() ? 0.55 : 1,
          }}
        >
          {t("analystPage.send")}
        </button>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("analystPage.disclaimer")}</p>
    </div>
  )
}
