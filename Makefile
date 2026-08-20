.PHONY: examples clean-examples docs

docs:
	npx typedoc

examples:
	cd examples/fetch && npm install && npm run asbuild
	cd examples/kv && npm install && npm run asbuild
	cd examples/rate-limit && npm install && npm run asbuild
	cd examples/json && npm install && npm run asbuild
	cd examples/redirect && npm install && npm run asbuild
	cd examples/webhook && npm install && npm run asbuild
	cd examples/headers && npm install && npm run asbuild
	cd examples/rewrite && npm install && npm run asbuild
	cd examples/udger && npm install && npm run asbuild
	cd examples/html-rewrite && npm install && npm run asbuild

clean-examples:
	rm -rf examples/fetch/build examples/fetch/node_modules
	rm -rf examples/kv/build examples/kv/node_modules
	rm -rf examples/rate-limit/build examples/rate-limit/node_modules
	rm -rf examples/json/build examples/json/node_modules
	rm -rf examples/redirect/build examples/redirect/node_modules
	rm -rf examples/webhook/build examples/webhook/node_modules
	rm -rf examples/headers/build examples/headers/node_modules
	rm -rf examples/rewrite/build examples/rewrite/node_modules
	rm -rf examples/udger/build examples/udger/node_modules
	rm -rf examples/html-rewrite/build examples/html-rewrite/node_modules
