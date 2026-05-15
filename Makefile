# pgStack — thin wrapper over build.sh so `make <target>` works where make is
# installed (Linux VPS, CI runners). On Windows/Git-Bash call ./build.sh directly.
.PHONY: build verify up down go examples clean
build verify up down go examples clean:
	@./build.sh $@
