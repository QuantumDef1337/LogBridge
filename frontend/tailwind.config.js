export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        brand: {
          50:  '#f0fdf9',
          100: '#ccfbef',
          200: '#99f6e0',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
        },
        zinc: {
          925: '#0e0e11',
          950: '#09090b',
        },
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
      },
      keyframes: {
        'fade-up': {
          '0%':   { opacity: '0', transform: 'translateY(16px)', filter: 'blur(3px)' },
          '100%': { opacity: '1', transform: 'translateY(0)',    filter: 'blur(0)' },
        },
        'fade-in': {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition: '200%  center' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.35' },
          '50%':      { opacity: '0.75' },
        },
        'pulse-dot': {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%':      { transform: 'scale(1.4)', opacity: '0.6' },
        },
      },
      animation: {
        'fade-up':    'fade-up 0.5s cubic-bezier(0.32,0.72,0,1) both',
        'fade-in':    'fade-in 0.3s ease both',
        shimmer:      'shimmer 2.4s linear infinite',
        'glow-pulse': 'glow-pulse 3.5s ease-in-out infinite',
        'pulse-dot':  'pulse-dot 2s ease-in-out infinite',
      },
      boxShadow: {
        'glow-teal':     '0 0 24px rgba(20,184,166,0.16), 0 0 6px rgba(20,184,166,0.08)',
        'glow-teal-sm':  '0 0 12px rgba(20,184,166,0.10)',
        'inner-lift':    'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.4)',
        'card':          '0 2px 16px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset',
        'card-hover':    '0 4px 28px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.32,0.72,0,1)',
      },
    },
  },
  plugins: [],
};
