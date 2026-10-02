// OpenCode 2 loads a plugin directory by resolving `<dir>/server` or `<dir>/index`, not through
// package.json, so a checkout installed by path needs this root entry. The build is in dist/.
export { default } from "./dist/index.js"
