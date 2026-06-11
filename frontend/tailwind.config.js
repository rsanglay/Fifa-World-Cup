/** @type {import('tailwindcss').Config} */
// FM / EAFC hybrid design system:
//   bg #0d1117 · surface #161b22 · accent #00d4aa · danger #e63946
//   text #f0f6fc / #8b949e · Inter for UI, Bebas Neue for scores
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pitch: { DEFAULT: "#1a5c2a", dark: "#14491f" },
        ink: { DEFAULT: "#0d1117", soft: "#11161f", card: "#161b22" },
        surface: "#161b22",
        gold: "#00d4aa", // accent (legacy token name kept across components)
        accent: "#00d4aa",
        danger: "#e63946",
        "txt-primary": "#f0f6fc",
        "txt-secondary": "#8b949e",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["'Bebas Neue'", "Impact", "sans-serif"],
      },
      keyframes: {
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.92) translateY(8px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-500px 0" },
          "100%": { backgroundPosition: "500px 0" },
        },
        "count-up": {
          "0%": { opacity: "0", transform: "translateY(10px) scale(0.8)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "pop-in": "pop-in 0.4s ease-out",
        shimmer: "shimmer 2s linear infinite",
        "count-up": "count-up 0.6s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
