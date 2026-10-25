export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
