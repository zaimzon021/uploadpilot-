'use strict';
// ALL YouTube Studio / Google selectors and texts live here so they can be fixed in one place after
// live verification. Each entry is a list of fallbacks tried in order (first visible match wins).
// Status: written from knowledge of Studio's DOM (ytcp-* web components). NOT yet verified live.
module.exports = {
  studio: {
    createButton: ['#create-icon', 'ytcp-button#create-icon', 'button[aria-label="Create"]', 'ytcp-button[aria-label="Create"]'],
    uploadMenuItem: ['tp-yt-paper-item#text-item-0', '#creation-menu tp-yt-paper-item:has-text("Upload videos")', 'tp-yt-paper-item:has-text("Upload videos")', '[test-id="upload-beta"]', 'text=Upload videos'],
    // Dashboard has a direct "Upload videos" button too
    dashboardUploadButton: ['ytcp-button#upload-button', '#upload-icon', 'ytcp-icon-button#upload-icon'],
    channelName: ['ytcp-navigation-drawer #entity-name', '#entity-name', 'ytcp-navigation-drawer .entity-name', '#channel-title'],
    appRoot: ['ytcp-app', 'ytcp-entity-page'],
  },
  dialog: {
    root: ['ytcp-uploads-dialog', '#dialog.ytcp-uploads-dialog'],
    fileInput: ['ytcp-uploads-file-picker input[type="file"]', 'input[type="file"][name="Filedata"]', 'ytcp-uploads-dialog input[type="file"]'],
    filePicker: ['ytcp-uploads-file-picker', '#select-files-button'],
    closeButton: ['ytcp-uploads-dialog #close-button', '#close-button'],
    // Stepper content panes (hidden attribute toggles as you move through the steps)
    detailsPane: ['ytcp-uploads-details', 'ytcp-video-metadata-editor-basics'],
    elementsPane: ['ytcp-uploads-video-elements'],
    checksPane: ['ytcp-uploads-checks', 'ytcp-checks-summary'],
    visibilityPane: ['ytcp-uploads-review', '#privacy-radios'],
    nextButton: ['#next-button', 'ytcp-button#next-button', 'ytcp-uploads-dialog button:has-text("Next")'],
    backButton: ['#back-button', 'ytcp-button#back-button'],
    doneButton: ['#done-button', 'ytcp-button#done-button', 'ytcp-uploads-dialog button:has-text("Publish")', 'ytcp-uploads-dialog button:has-text("Save")'],
    progressLabel: ['ytcp-video-upload-progress .progress-label', 'ytcp-uploads-dialog .progress-label', 'span.progress-label'],
    videoUrl: ['ytcp-video-info .video-url-fadeable a', '.video-url-fadeable a', 'ytcp-video-info a[href*="youtu"]'],
  },
  details: {
    titleBox: ['#title-textarea #textbox', 'ytcp-social-suggestions-textbox#title-textarea #textbox', '#textbox[aria-label*="title" i]', 'div#textbox[contenteditable="true"]'],
    descriptionBox: ['#description-textarea #textbox', 'ytcp-social-suggestions-textbox#description-textarea #textbox', '#textbox[aria-label*="Tell viewers" i]'],
    kidsYes: ['tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_MFK"]', '[name="VIDEO_MADE_FOR_KIDS_MFK"]'],
    kidsNo: ['tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]', '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'],
    showMore: ['ytcp-button#toggle-button:has-text("Show more")', '#toggle-button:has-text("Show more")', 'button:has-text("Show more")', '#toggle-button'],
    tagsInput: ['ytcp-form-input-container#tags-container input#text-input', '#tags-container input', 'input[aria-label="Tags"]', 'ytcp-chip-bar input'],
    thumbnailInput: ['input#file-loader', 'ytcp-thumbnails-compact-editor-uploader input[type="file"]', 'ytcp-thumbnail-uploader input[type="file"]'],
  },
  visibility: {
    radio: v => [`tp-yt-paper-radio-button[name="${v}"]`, `#privacy-radios [name="${v}"]`],
    scheduleExpand: ['#second-container-expand-button', 'ytcp-visibility-scheduler #second-container-expand-button'],
    scheduleDateTrigger: ['#datepicker-trigger', 'ytcp-date-picker #datepicker-trigger'],
    scheduleDateInput: ['ytcp-date-picker tp-yt-paper-input input', 'tp-yt-paper-dialog#dialog input.tp-yt-paper-input'],
    scheduleTimeInput: ['#time-of-day-container input', 'ytcp-form-input-container#time-of-day-container input'],
  },
  done: {
    dialog: ['ytcp-video-share-dialog', 'ytcp-uploads-still-processing-dialog', 'ytcp-prechecks-warning-dialog'],
    url: ['ytcp-video-share-dialog #share-url', 'ytcp-video-share-dialog a[href*="youtu"]', 'ytcp-uploads-still-processing-dialog a[href*="youtu"]'],
    close: ['ytcp-video-share-dialog #close-button', 'ytcp-uploads-still-processing-dialog #close-button', 'ytcp-uploads-still-processing-dialog ytcp-button:has-text("Close")', '#close-button'],
  },
  // Content list (Studio → Content → Videos) used for the duplicate check before a retry. NOT verified live.
  content: {
    row: ['ytcp-video-row', '#row-container.ytcp-video-row'],
    title: ['#video-title', 'a#video-title', '.video-title-wrapper #video-title'],
    link: ['a#video-title', 'a[href*="/video/"]', '#thumbnail-anchor'],
  },
  // generic dialogs we may need to dismiss during recovery
  dismiss: ['ytcp-dialog #close-button', 'tp-yt-paper-dialog #close-button', 'ytcp-button:has-text("Close")', 'ytcp-button:has-text("Got it")', 'ytcp-button:has-text("Dismiss")', 'button:has-text("OK")', 'button:has-text("Got it")', 'button:has-text("No thanks")', 'button:has-text("Not now")', 'ytcp-button:has-text("Continue")', '[aria-label="Close"]'],
  google: {
    emailInput: ['#identifierId', 'input[type="email"]'],
    passwordInput: ['input[type="password"][name="Passwd"]', 'input[type="password"]'],
  },
  // Text patterns (lower-cased match) used by the state detector
  text: {
    errorDialog: ['something went wrong', 'an error occurred', 'oops', 'try again later', 'upload failed', 'error processing', "couldn't upload", 'could not upload', 'network error'],
    uploadLimit: ['daily upload limit', 'upload limit reached', "you've reached your upload limit", 'too many uploads'],
    verification: ["verify it's you", 'verify that it’s you', 'unusual traffic', "confirm you're not a robot", 'i\'m not a robot', 'recaptcha', 'enter the characters you see', 'verify your identity', 'phone verification'],
    newDevice: ["confirm it's you", 'new device', 'check your phone', 'google sent a notification', 'tap yes on your phone', '2-step verification'],
    noChannel: ['create channel', 'choose how to create your channel', 'create a channel'],
    doneDialog: ['video published', 'video processing', 'video saved', 'video uploaded', 'video scheduled', 'still processing', 'processing will begin', 'video link', 'share video', 'upload complete'],
    uploadComplete: ['upload complete', 'processing', 'checks complete', 'processed', 'finished processing', 'no issues found', 'video uploaded'],
    draft: ['draft', 'edit draft', 'upload incomplete', 'processing abandoned'],
    uploadFailed: ['upload failed', 'processing abandoned', 'upload canceled', 'upload cancelled', 'file is too large', 'invalid file format', 'duplicate upload'],
  },
};
