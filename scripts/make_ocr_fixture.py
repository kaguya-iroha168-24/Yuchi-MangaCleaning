"""Create a clearly synthetic Japanese OCR integration fixture locally."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parents[1]
folder=root/'.cache/shima-parity/fixtures';folder.mkdir(parents=True,exist_ok=True)
font=ImageFont.truetype('C:/Windows/Fonts/YuGothM.ttc',48)
image=Image.new('RGB',(820,130),'white')
ImageDraw.Draw(image).text((24,30),'こんにちは。今日はいい天気です。',font=font,fill='black')
image.save(folder/'ocr-japanese-synthetic.png')
print(str(folder/'ocr-japanese-synthetic.png'))
