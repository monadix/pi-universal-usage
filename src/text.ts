/**
 * Terminal-safe plain text for values derived from remote responses or runtime
 * registrations. Pi's text widget preserves ANSI sequences, so control and
 * escape sequences must be removed at this package's output boundaries instead
 * of relying on layout to neutralize them.
 */

const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const C1_CSI_SEQUENCE = /\u009b[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_SEQUENCE = /\u001b[@-_]/gu;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Remove terminal escape/control sequences while preserving ordinary text. */
export function plainText(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(C1_CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(BIDI_CONTROLS, "")
    .replace(CONTROL_CHARACTERS, "");
}
