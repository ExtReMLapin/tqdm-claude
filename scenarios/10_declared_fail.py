"""A long-lived process that declares its own failure and keeps running ~20 s. Expect: failed at once, before the process exits."""
import time

print("##progress step=1/2 label=\"Warm up server\"", flush=True)
time.sleep(3)
print('##progress done=fail msg="port 8080 already in use"', flush=True)
time.sleep(20)
