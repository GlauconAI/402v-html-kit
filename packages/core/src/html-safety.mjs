const PASSIVE_NAVIGATION_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const NETWORK_SIDE_EFFECT_ATTRIBUTES = new Set([
  "action",
  "background",
  "formaction",
  "ping",
]);

export function asciiLowercase(value) {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

export function isEventHandlerAttribute(name) {
  return asciiLowercase(name).startsWith("on");
}

export function isNetworkSideEffectAttribute(name) {
  return NETWORK_SIDE_EFFECT_ATTRIBUTES.has(asciiLowercase(name));
}

export function isUnsafePassiveNavigationUrl(value) {
  const colon = value.indexOf(":");
  if (colon < 0) return false;
  const candidate = asciiLowercase(value.slice(0, colon)).replace(
    /[\u0000-\u0020\u007f]/g,
    "",
  );
  const scheme = /^[a-z][a-z0-9+.-]*$/.test(candidate) ? candidate : undefined;
  return scheme !== undefined && !PASSIVE_NAVIGATION_SCHEMES.has(scheme);
}
