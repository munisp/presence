# AMD-MAP-01/06: the static-tile service (TR-44). Two stages — the python
# stage renders the governed basemap into the XYZ pyramid with the
# deterministic builder and VERIFIES the render (--check), the nginx stage
# serves the verified bytes. There is no runtime tile server: nginx hands
# out static files, which is the whole point of TR-44.
FROM python:3.12-alpine AS build
WORKDIR /bundle
RUN pip install --no-cache-dir "Pillow==11.3.0"
COPY maps/basemap/lagos.json maps/basemap/lagos.json
COPY scripts/build_tiles.py scripts/build_tiles.py
RUN python3 scripts/build_tiles.py --out build/tiles \
 && python3 scripts/build_tiles.py --out build/tiles --check

FROM nginx:1.27-alpine
COPY tiles/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /bundle/build/tiles/ /usr/share/nginx/html/bundles/
# The image carries ONE governed bundle (built from the in-repo source
# above); "current" aliases it so the same-origin proxies can serve
# /tiles/... without knowing the version. A bundle bump ships a new
# image — the AMD-MAP-02 registry is the discovery record that pins
# which version (and which tile hash) the platform SHOULD be serving.
RUN ln -sfn /usr/share/nginx/html/bundles/1.0.0 /usr/share/nginx/html/bundles/current
EXPOSE 8080
