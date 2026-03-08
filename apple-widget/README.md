# Apple WidgetKit Scaffold

This folder contains a macOS app + WidgetKit extension scaffold that reads contacts from your ZimaOS endpoint.

## Prerequisites

- Full Xcode installed (not only Command Line Tools)
- Optional: xcodegen (`brew install xcodegen`)

## Generate project

```bash
cd apple-widget
xcodegen generate
```

This creates `BrandMeisterWidgetKit.xcodeproj`.

## Build

```bash
xcodebuild -project BrandMeisterWidgetKit.xcodeproj -scheme BrandMeisterMac -configuration Debug build
```

## Configure endpoint

Run the mac app once and set endpoint in the app UI:

- Default: `http://127.0.0.1:8787/widget/contacts`
- ZimaOS: `http://<zima-ip>:8787/widget/contacts`

<<<<<<< HEAD
The app saves settings in App Group defaults, lets you test the endpoint from the macOS app, and reloads widget timelines.
=======
The app saves settings in App Group defaults and reloads widget timelines.
>>>>>>> 23a159dbfa4a4f5f48e3730b57792cc349883956

## Important

Update these before distribution:

<<<<<<< HEAD
- App Group ID: `group.com.osviel91.brandmeister`
- Bundle IDs in `project.yml`
- Signing team in Xcode

Both the macOS app and the widget extension already include matching App Group entitlements; if you change the group ID, update it in `Shared/BrandMeisterModels.swift`, `MacApp/BrandMeisterMac.entitlements`, and `WidgetExtension/BrandMeisterWidget.entitlements`.
=======
- App Group ID: `group.com.example.brandmeister`
- Bundle IDs in `project.yml`
- Signing team in Xcode
>>>>>>> 23a159dbfa4a4f5f48e3730b57792cc349883956
