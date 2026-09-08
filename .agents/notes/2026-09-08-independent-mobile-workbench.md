# Independent mobile workbench

Aura owns its Expo client and HTTP adapter. Official DSH is pinned as a dependency and launched exclusively through a supported profile; no upstream source is vendored or edited. The profile disables shell and editor consumers for the keyless demo.

The default offline transport makes the packaged UI usable without credentials or a running computer. An optional DSH-backed transport verifies SDK handshake, prompt submission, streamed session events and request cancellation. It uses a local fake model and one process per request; production session persistence and authentication remain deferred.

The purple/black and light themes share semantic tokens, reusable controls and reduced-motion behavior. The same React Native screens export to mobile web and native bundles. Android preview packaging includes the JavaScript assets; iOS installation needs a Mac or an explicitly configured EAS build and signing identity.
