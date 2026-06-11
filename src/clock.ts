const BACKWARD_TOLERANCE = 3600;        // 1h
const FORWARD_JUMP_LIMIT = 30 * 86400;  // 30d

/** True if (lastSeen, now) indicates clock tampering (parity with Swift/Rust). */
export function clockManipulated(lastSeen: number, now: number): boolean {
  const drift = lastSeen - now; // positive => clock went backward
  if (drift > BACKWARD_TOLERANCE) return true;
  if (now - lastSeen > FORWARD_JUMP_LIMIT) return true;
  return false;
}
