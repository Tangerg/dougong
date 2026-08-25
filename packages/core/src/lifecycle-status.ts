// One status vocabulary for Installation and Group alike. They report the same
// five words because an installation-ownership subtree has no state of its own
// beyond its contents' — a separate `GroupStatus` would be a second spelling of
// the same five cases, and would drift.
export type LifecycleStatus = "pending" | "active" | "stopping" | "failed" | "removed";
