// Native keys can be nonconfigurable; replace the constructor before loading consumers.
const maskedSymbol = Symbol.bind(undefined);
const descriptors = Object.getOwnPropertyDescriptors(Symbol);
delete descriptors.dispose;
delete descriptors.asyncDispose;
Object.defineProperties(maskedSymbol, descriptors);
globalThis.Symbol = maskedSymbol;
