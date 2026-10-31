export function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

export function taggedTheme() {
  return { ...fakeTheme(), fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
}
