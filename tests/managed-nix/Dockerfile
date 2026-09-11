FROM docker.io/library/debian:bookworm-slim@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867
COPY store/ /nix/store/
COPY packages/ /fixture/packages/
COPY dearmachine /fixture/dearmachine
RUN mkdir -p /fixture/node_modules/@dearmachine && ln -s ../../packages/product-adapter /fixture/node_modules/@dearmachine/machtiani-installer-products
COPY tests/ /fixture/tests/
ARG NODE_PACKAGE
ARG ZSH_PACKAGE
ARG NIX_PACKAGE
ENV NODE_PACKAGE=$NODE_PACKAGE ZSH_PACKAGE=$ZSH_PACKAGE NIX_PACKAGE=$NIX_PACKAGE MANAGED_NIX_CONTAINER=1
WORKDIR /fixture
CMD ["sh", "-c", "exec \"$NODE_PACKAGE/bin/node\" --test tests/managed-nix/lifecycle.mjs"]
