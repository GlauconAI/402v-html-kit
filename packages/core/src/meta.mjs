function asciiLowercase(value) {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

export function findMetaElements(document, name) {
  const expected = asciiLowercase(name);
  return [...document.querySelectorAll("meta[name]")].filter(
    (element) => asciiLowercase(element.getAttribute("name") ?? "") === expected,
  );
}
