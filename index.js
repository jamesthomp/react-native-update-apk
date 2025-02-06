"use strict";

import { Alert, NativeModules, Platform } from "react-native";
import ReactNativeBlobUtil from "react-native-blob-util";

const RNUpdateAPK = NativeModules.RNUpdateAPK;

function semverLt(v1, v2) {
  const parse = (v) => v.split(".").map(Number);
  const [a1, b1, c1] = parse(v1);
  const [a2, b2, c2] = parse(v2);

  return (
    a1 < a2 || (a1 === a2 && b1 < b2) || (a1 === a2 && b1 === b2 && c1 < c2)
  );
}

function processFile(downloadDestPath, fileProviderAuthority, onError) {
  RNUpdateAPK.getApkInfo(downloadDestPath)
    .then((res) => {
      console.log(
        "RNUpdateAPK::downloadApk - Old Cert SHA-256: " +
          RNUpdateAPK.signatures[0].thumbprint
      );
      console.log(
        "RNUpdateAPK::downloadApk - New Cert SHA-256: " +
          res.signatures[0].thumbprint
      );
      if (
        res.signatures[0].thumbprint !== RNUpdateAPK.signatures[0].thumbprint
      ) {
        // FIXME should add extra callback for this
        console.log(
          "The signature thumbprints seem unequal. Install will fail"
        );
      } else {
        if (!canRequestPackageInstalls()) {
          Alert.alert(
            "Enable Install Unknown Apps",
            "To update, please enable 'Install unknown apps' for this app by clicking 'settings' on the next prompt.",
            [
              {
                text: "OK",
                onPress: () => {
                  RNUpdateAPK.installApk(
                    downloadDestPath,
                    fileProviderAuthority
                  );
                },
              },
            ],
            { cancelable: false }
          );
        } else {
          RNUpdateAPK.installApk(downloadDestPath, fileProviderAuthority);
        }
      }
    })
    .catch((rej) => {
      console.log("RNUpdateAPK::downloadApk - apk info error: ", rej);
      onError && onError("Failed to get Downloaded APK Info");
      // re-throw so we don't attempt to install the APK, this will call the downloadApkError handler
      throw rej;
    });
}

export class UpdateAPK {
  constructor(options) {
    this.options = options;
  }

  get = (url, success, error, options = {}) => {
    fetch(url, options)
      .then((response) => {
        if (!response.ok) {
          let message;
          if (response.statusText) {
            message = `${response.url}  ${response.statusText}`;
          } else {
            message = `${response.url} Status Code:${response.status}`;
          }
          throw Error(message);
        }
        return response;
      })
      .then((response) => response.json())
      .then((json) => {
        success && success(json);
      })
      .catch((err) => {
        error && error(err);
      });
  };

  getApkVersion = () => {
    if (!this.options.apkVersionUrl) {
      console.log("RNUpdateAPK::getApkVersion - apkVersionUrl doesn't exist.");
      return;
    }
    this.get(
      this.options.apkVersionUrl,
      this.getApkVersionSuccess.bind(this),
      this.getVersionError.bind(this),
      this.options.apkVersionOptions
    );
  };

  getApkVersionSuccess = (remote) => {
    let outdated = false;
    if (remote.versionCode && remote.versionCode > RNUpdateAPK.versionCode) {
      console.log(
        "RNUpdateAPK::getApkVersionSuccess - outdated based on code, local/remote: " +
          RNUpdateAPK.versionCode +
          "/" +
          remote.versionCode
      );
      outdated = true;
    }
    if (
      !remote.versionCode &&
      semverLt(RNUpdateAPK.versionName, remote.versionName)
    ) {
      console.log(
        "RNUpdateAPK::getApkVersionSuccess - APK outdated based on version name, local/remote: " +
          RNUpdateAPK.versionName +
          "/" +
          remote.versionName
      );
      outdated = true;
    }
    if (outdated) {
      if (this.options.needUpdateApp) {
        this.options.needUpdateApp((isUpdate) => {
          if (isUpdate) {
            this.downloadApk(remote);
          }
        }, remote);
      }
    } else if (this.options.notNeedUpdateApp) {
      this.options.notNeedUpdateApp();
    }
  };

  downloadApk = async (remote) => {
    // You must be sure filepaths.xml exposes this path or you will have a FileProvider error API24+
    // You might check {totalSpace, freeSpace} = await RNFS.getFSInfo() to make sure there is room
    const downloadDestPath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/SL.apk`;
    const exists = await ReactNativeBlobUtil.fs.exists(downloadDestPath);
    if (exists) {
      try {
        const info = await RNUpdateAPK.getApkInfo(downloadDestPath);
        if (info.versionCode == remote.versionCode) {
          console.log(
            "RNUpdateAPK::downloadApk - APK already downloaded and up to date"
          );
          processFile(
            downloadDestPath,
            this.options.fileProviderAuthority,
            this.options.onError
          );
          return;
        } else {
          console.log("APK exists but is outdated, removing");
          await ReactNativeBlobUtil.fs.unlink(downloadDestPath);
        }
      } catch (e) {
        console.log("Error with existing file, removing", e);
        await ReactNativeBlobUtil.fs.unlink(downloadDestPath);
      }
    }

    const ret = ReactNativeBlobUtil.config({
      path: downloadDestPath,
    })
      .fetch("GET", remote.apkUrl)
      .progress((received, total) => {
        const percentage = ((100 * received) / total).toFixed(2);
        this.options.downloadApkProgress &&
          this.options.downloadApkProgress(percentage);
      });

    ret
      .then((res) => {
        const status = res.info().status;
        if (status >= 400 && status <= 599) {
          throw (
            "Failed to Download APK. Server returned with " +
            status +
            " statusCode"
          );
        }
        console.log("RNUpdateAPK::downloadApk - downloadApkEnd");
        this.options.downloadApkEnd && this.options.downloadApkEnd();
        processFile(
          downloadDestPath,
          this.options.fileProviderAuthority,
          this.options.onError
        );
      })
      .catch((err) => {
        this.downloadApkError(err);
      });
  };

  getAppStoreVersion = () => {
    if (!this.options.iosAppId) {
      console.log("RNUpdateAPK::getAppStoreVersion - iosAppId doesn't exist.");
      return;
    }
    const URL = "https://itunes.apple.com/lookup?id=" + this.options.iosAppId;
    console.log("RNUpdateAPK::getAppStoreVersion - attempting to fetch " + URL);
    this.get(
      URL,
      this.getAppStoreVersionSuccess.bind(this),
      this.getVersionError.bind(this)
    );
  };

  getAppStoreVersionSuccess = (data) => {
    if (data.resultCount < 1) {
      console.log(
        "RNUpdateAPK::getAppStoreVersionSuccess - iosAppId is wrong."
      );
      return;
    }
    const result = data.results[0];
    const version = result.version;
    const trackViewUrl = result.trackViewUrl;

    if (semverLt(RNUpdateAPK.versionName, version)) {
      console.log(
        "RNUpdateAPK::getAppStoreVersionSuccess - outdated based on version name, local/remote: " +
          RNUpdateAPK.versionName +
          "/" +
          version
      );
      if (this.options.needUpdateApp) {
        this.options.needUpdateApp((isUpdate) => {
          if (isUpdate) {
            RNUpdateAPK.installFromAppStore(trackViewUrl);
          }
        });
      }
    } else {
      this.options.notNeedUpdateApp && this.options.notNeedUpdateApp();
    }
  };

  getVersionError = (err) => {
    console.log("RNUpdateAPK::getVersionError - getVersionError", err);
    this.options.onError && this.options.onError(err);
  };

  downloadApkError = (err) => {
    console.log("RNUpdateAPK::downloadApkError - downloadApkError", err);
    this.options.onError && this.options.onError(err);
  };

  checkUpdate = () => {
    if (Platform.OS === "android") {
      this.getApkVersion();
    } else {
      this.getAppStoreVersion();
    }
  };
}

export function getInstalledVersionName() {
  return RNUpdateAPK.versionName;
}
export function getInstalledVersionCode() {
  return RNUpdateAPK.versionCode;
}
export function getInstalledPackageName() {
  return RNUpdateAPK.packageName;
}
export function getInstalledFirstInstallTime() {
  return RNUpdateAPK.firstInstallTime;
}
export function getInstalledLastUpdateTime() {
  return RNUpdateAPK.lastUpdateTime;
}
export function getInstalledPackageInstaller() {
  return RNUpdateAPK.packageInstaller;
}
export function getInstalledSigningInfo() {
  return RNUpdateAPK.signatures;
}
export function canRequestPackageInstalls() {
  return RNUpdateAPK.canRequestPackageInstalls;
}

export async function getApps() {
  if (Platform.OS === "android") {
    return RNUpdateAPK.getApps();
  } else {
    return [];
  }
}
export async function getNonSystemApps() {
  if (Platform.OS === "android") {
    return RNUpdateAPK.getNonSystemApps();
  } else {
    return [];
  }
}
