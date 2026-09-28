declare module '*.md' {
  const text: string;
  export default text;
}
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
