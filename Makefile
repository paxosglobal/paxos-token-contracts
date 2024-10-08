.PHONY:all
all: setup fmt compile generate-bin test-contracts-coverage

.PHONY:clean
clean:
	@rm -r build/ || true

##################
# Code
##################

.PHONY:setup
setup:
	yarn install --ignore-optional

.PHONY:fmt
fmt:
	@npm run solhint

.PHONY:ganache
ganache:
	@npm run ganache

.PHONY:compile
compile:
	@npm run compile

.PHONY:generate-bin
generate-bin: compile
	@npm run generate-abi
	@npm run generate-bin

# compile is needed as a dependency here to ensure the zos-lib based tests work
.PHONY:test-contracts
test-contracts: compile
	@npm test

# TODO: get tests to pass in coverage env
.PHONY:test-contracts-coverage
test-contracts-coverage:
	@npm run coverage
