export const DRIVER_INVISIBLE = "driver-invisible";
export const DRIVER_AWARE = "driver-aware";

export const GOLDEN_ARM_IMPLEMENTATIONS = Object.freeze({
	A: "main-json",
	B: "control",
	C: "samehead",
});

export function implementationArm(arm) {
	return GOLDEN_ARM_IMPLEMENTATIONS[arm] ?? arm;
}

export function sameHeadDeliveryContext(state, head) {
	return {
		...state,
		pending: state.pending.filter((item) => item.head === head),
	};
}

const buckets = new Map([
	["none", DRIVER_INVISIBLE],
	["print", DRIVER_INVISIBLE],
	["queue", DRIVER_AWARE],
	["steer", DRIVER_AWARE],
	["interrupt", DRIVER_AWARE],
]);

export function deliveryBucket(delivery) {
	const bucket = buckets.get(delivery);
	if (!bucket) throw new Error(`unknown delivery: ${delivery}`);
	return bucket;
}

export function sameDeliveryBucket(actual, expected) {
	return deliveryBucket(actual) === deliveryBucket(expected);
}

export function isDeliveryBucketCorrect(actual, expected) {
	return typeof actual === "string" && sameDeliveryBucket(actual, expected);
}

// TODO: Revisit whether interrupt needs its own bucket and urgency-specific
// gates once the corpus has enough emergency and near-emergency observations.
