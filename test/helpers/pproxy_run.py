# Runs pproxy (independent third-party SOCKS5 server implementation) with a plain asyncio loop.
import sys, asyncio
sys.modules['uvloop'] = None          # pproxy+uvloop is broken on Python 3.12
asyncio.set_event_loop(asyncio.new_event_loop())
import pproxy.server
sys.argv = ['pproxy'] + sys.argv[1:]
pproxy.server.main()
