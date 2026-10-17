import type { Config } from "tailwindcss";

// Light theme in the logo colours (cyan → blue → violet). Colours are semantic (surface / text / line) so components
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
        // Surfaces: white canvas stepping into a pale blue. Never name a colour "base": text-base is also the font-size class.
        canvas: "#ffffff",
        alt: "#f5f8ff",
        card: "#ffffff",
        chip: "rgb(37 99 235 / 0.08)",
        // Hairlines
        line: "#e3e8f4",
        "line-strong": "#c9d3ea",
        // Text: logo navy for headings, blue-grey for body. faint is the lightest grey that passes AA on canvas and alt.
        ink: "#0e0a2e",
        body: "#3d4766",
        muted: "#5b6584",
        faint: "#68718e",
        // Logo shield: cyan → blue → violet. Cyan is for fills and glows only, never text on white.
        brand: {
          DEFAULT: "#2563eb",
          dark: "#1a4fa0",
          deep: "#4c1d95",
          cyan: "#22b8d6",
          violet: "#6d28d9",
        },
        // Accent text and focus rings: a blue that passes AA on white
        accent: "#1d4ed8",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(14 10 46 / 0.05), 0 10px 28px -18px rgb(14 10 46 / 0.18)",
        float: "0 0 0 1px rgb(37 99 235 / 0.06), 0 28px 60px -26px rgb(37 99 235 / 0.3), 0 28px 70px -34px rgb(109 40 217 / 0.2)",
        glow: "0 8px 24px -8px rgb(37 99 235 / 0.45), 0 10px 32px -14px rgb(109 40 217 / 0.3)",
        surface: "0 1px 2px 0 rgb(14 10 46 / 0.05), 0 40px 90px -40px rgb(37 99 235 / 0.3), 0 40px 100px -50px rgb(109 40 217 / 0.2)",
      },
    },
  },
  plugins: [],
};

export default config;
