tell application "System Events"
    repeat 40 times
        if exists process "CoreServicesUIAgent" then
            tell process "CoreServicesUIAgent"
                repeat with dialogWindow in windows
                    if exists button "Open" of dialogWindow then
                        set frontmost to true
                        click button "Open" of dialogWindow
                        return "Accepted browser first-open confirmation"
                    end if
                end repeat
            end tell
        end if
        delay 0.25
    end repeat
    return "No browser first-open confirmation"
end tell
