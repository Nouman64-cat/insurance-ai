import type { Config } from "tailwindcss";

// White & blue theme. Colours are semantic (surface / text / line) so components
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
        // Surfaces: white, stepping into pale blue
        base: "#ffffff",
        alt: "#f3f7ff",
        card: "#ffffff",
        chip: "#e8f0fe",
        // Hairlines
        line: "#dce7f8",
        "line-strong": "#b5caee",
        // Text: deep navy for headings, blue-grey for body
        ink: "#0b1b3f",
        body: "#3a4a6b",
        muted: "#586a8d",
        faint: "#66789c",
        // Blues
        brand: {
          DEFAULT: "#2563eb",
          dark: "#1d4ed8",
          deep: "#0a2370",
        },
        accent: "#1d4ed8",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 35 90 / 0.05), 0 10px 28px -18px rgb(15 35 90 / 0.18)",
        float: "0 0 0 1px rgb(37 99 235 / 0.08), 0 28px 60px -26px rgb(37 99 235 / 0.4)",
        glow: "0 10px 28px -10px rgb(37 99 235 / 0.6)",
      },
    },
  },
  plugins: [],
};

export default config;
