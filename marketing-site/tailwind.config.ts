import type { Config } from "tailwindcss";

// Dark & violet theme. Colours are semantic (surface / text / line) so components
// never name a literal shade: change the palette here and the whole site follows.
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./content/**/*.{js,ts}",
    "./lib/**/*.{js,ts}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      colors: {
        // Surfaces: near-black canvas stepping up to translucent glass. Never name a colour "base": text-base is also the font-size class.
        canvas: "#07070c",
        alt: "#0d0d16",
        card: "rgb(255 255 255 / 0.03)",
        chip: "rgb(124 58 237 / 0.15)",
        // Hairlines
        line: "rgb(255 255 255 / 0.08)",
        "line-strong": "rgb(255 255 255 / 0.16)",
        // Text: near-white headings, cool grey body
        ink: "#f5f5fa",
        body: "#b4b4c8",
        muted: "#8a8aa3",
        faint: "#7d7d98",
        // Violets
        brand: {
          DEFAULT: "#7c3aed",
          dark: "#6d28d9",
          deep: "#4c1d95",
        },
        accent: "#a78bfa",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(0 0 0 / 0.4), 0 12px 32px -18px rgb(0 0 0 / 0.7)",
        float: "0 0 0 1px rgb(124 58 237 / 0.18), 0 28px 60px -26px rgb(124 58 237 / 0.45)",
        glow: "0 0 40px -8px rgb(124 58 237 / 0.6)",
        surface: "0 1px 2px 0 rgb(0 0 0 / 0.5), 0 40px 90px -40px rgb(124 58 237 / 0.4)",
      },
    },
  },
  plugins: [],
};

export default config;
