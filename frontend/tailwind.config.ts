import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      colors: {
        // Match Copilot’s neutral surfaces and text instead of blue-grey slate.
        slate: colors.zinc,
        brand: {
          DEFAULT: "#2563EB",
          dark: "#1D4ED8",
          light: "#EFF6FF",
        },
      },
      // Pages use `max-w-screen-2xl` as their content width. It used to stop at 1536px, which left wide
      // monitors with empty bands either side of a narrow column; now it grows with the screen and
      // only stops at 2400px so lines never become unreadably long on an ultra-wide display.
      maxWidth: {
        "screen-2xl": "min(100%, 2400px)",
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.07), 0 1px 2px -1px rgb(0 0 0 / 0.07)",
      },
    },
  },
  plugins: [],
};

export default config;
