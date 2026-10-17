import type { Config } from "tailwindcss";

// Same theme as the staff portal (frontend/tailwind.config.ts): Inter, the blue/slate palette, `brand` and the card shadow.
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}", "./lib/**/*.{js,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["var(--font-inter)", "system-ui", "sans-serif"] },
      colors: { brand: { DEFAULT: "#1D4ED8", dark: "#1E3A8A", light: "#DBEAFE" } },
      maxWidth: { "screen-2xl": "min(100%, 2400px)" },
      boxShadow: { card: "0 1px 3px 0 rgb(0 0 0 / 0.07), 0 1px 2px -1px rgb(0 0 0 / 0.07)" },
    },
  },
  plugins: [],
};

export default config;
