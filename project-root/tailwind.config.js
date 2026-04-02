/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./frontend/**/*.{html,js}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "primary": "#1e68f1",
        "background-light": "#f5f6f8",
        "background-dark": "#101622",
      },
      fontFamily: {
        "display": ["Inter", "sans-serif"],
      },
      borderRadius: {
        "DEFAULT": "0.25rem",
        "lg": "0.5rem",
        "xl": "0.75rem",
        "full": "9999px",
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
  ],
}
