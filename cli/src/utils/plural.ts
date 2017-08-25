export default function plural(
  value: number,
  single: string,
  multiple: string
) {
  return value === 1 ? single : multiple;
}
