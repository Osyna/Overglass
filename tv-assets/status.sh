#!/bin/sh
# Status read run by dispatch.sh `status`: four JSON documents (power, foreground app, Home manifest, temperature); fixed local reads only.
luna-send -n 1 -w 1500 luna://com.webos.service.tvpower/power/getPowerState '{}' </dev/null
luna-send -n 1 -w 1500 luna://com.webos.applicationManager/getForegroundAppInfo '{}' </dev/null
cat /usr/palm/applications/com.webos.app.home/appinfo.json
# LG kernel SoC die sensor, integer degC; emit null on any unreadable/odd value (digits-only, 1-999).
t=$(cat /proc/thermalinfo/soc_temperature 2>/dev/null </dev/null)
case "$t" in
  [1-9]|[1-9][0-9]|[1-9][0-9][0-9]) printf '\n{"temperature_millicelsius":%s000,"temperature_source":"soc"}\n' "$t" ;;
  *) printf '\n{"temperature_millicelsius":null,"temperature_source":null}\n' ;;
esac
